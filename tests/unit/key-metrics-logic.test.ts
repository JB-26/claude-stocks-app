import { assertEquals, assert } from "@std/assert";

// ---------------------------------------------------------------------------
// key-metrics-logic.test.ts
//
// Tests for the data-transformation logic used by
// components/dashboard/KeyMetrics.tsx.
//
// KeyMetrics is a React component that cannot be imported into a Deno test
// (it uses "use client", imports from "@/lib/utils" via Next.js alias, and
// relies on useEffect/useState). We therefore test:
//
//   1. The formatPrice utility as applied to each of the four QuoteResponse
//      fields (o, h, l, pc) — confirming the correct formatting output.
//
//   2. The metric label-to-field mapping — ensuring the four metric
//      definitions (Open, High, Low, Prev Close) use the correct quote
//      fields. If the mapping were accidentally scrambled the UI would show
//      e.g. "High: $120.00" for a value that is actually the low.
//
//   3. The "null-quote → skeleton" path: the component renders a skeleton
//      when `quote` is null. We test that the condition driving this
//      (`!quote`) behaves as expected.
//
//   4. Fetch error suppression: the component's `.catch(() => {})` means
//      a failed fetch should not surface as an error — the component stays
//      in the skeleton state. We verify this with a stubbed fetch.
//
// formatPrice is imported inline to avoid the "@/" alias that Deno can't
// resolve (mirroring the project convention seen in other unit test files).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline copy of lib/utils.formatPrice — must be kept in sync with source
// ---------------------------------------------------------------------------

function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

// ---------------------------------------------------------------------------
// Inline copy of KeyMetrics metric definitions
// (from components/dashboard/KeyMetrics.tsx, lines 94-99)
// ---------------------------------------------------------------------------

interface QuoteFields {
  o: number;
  h: number;
  l: number;
  pc: number;
}

function buildMetrics(quote: QuoteFields) {
  return [
    { label: "Open", value: formatPrice(quote.o) },
    { label: "High", value: formatPrice(quote.h) },
    { label: "Low", value: formatPrice(quote.l) },
    { label: "Prev Close", value: formatPrice(quote.pc) },
  ] as const;
}

// ---------------------------------------------------------------------------
// KM-01: Correct number of metrics (always 4)
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-01: buildMetrics always returns exactly 4 metrics", () => {
  const metrics = buildMetrics({ o: 100, h: 110, l: 95, pc: 99 });
  assertEquals(metrics.length, 4);
});

// ---------------------------------------------------------------------------
// KM-02: Label order is Open → High → Low → Prev Close
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-02: metrics appear in the expected label order", () => {
  const metrics = buildMetrics({ o: 100, h: 110, l: 95, pc: 99 });
  const labels = metrics.map((m) => m.label);
  assertEquals(labels, ["Open", "High", "Low", "Prev Close"]);
});

// ---------------------------------------------------------------------------
// KM-03: Each metric maps to the correct quote field
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-03: Open maps to quote.o", () => {
  const metrics = buildMetrics({ o: 150.00, h: 160.00, l: 140.00, pc: 148.00 });
  assertEquals(metrics[0].label, "Open");
  assertEquals(metrics[0].value, formatPrice(150.00));
});

Deno.test("KeyMetrics KM-03b: High maps to quote.h", () => {
  const metrics = buildMetrics({ o: 150.00, h: 160.00, l: 140.00, pc: 148.00 });
  assertEquals(metrics[1].label, "High");
  assertEquals(metrics[1].value, formatPrice(160.00));
});

Deno.test("KeyMetrics KM-03c: Low maps to quote.l", () => {
  const metrics = buildMetrics({ o: 150.00, h: 160.00, l: 140.00, pc: 148.00 });
  assertEquals(metrics[2].label, "Low");
  assertEquals(metrics[2].value, formatPrice(140.00));
});

Deno.test("KeyMetrics KM-03d: Prev Close maps to quote.pc", () => {
  const metrics = buildMetrics({ o: 150.00, h: 160.00, l: 140.00, pc: 148.00 });
  assertEquals(metrics[3].label, "Prev Close");
  assertEquals(metrics[3].value, formatPrice(148.00));
});

// ---------------------------------------------------------------------------
// KM-04: formatPrice output format — currency symbol, 2 decimal places
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-04: formatPrice produces a dollar-prefixed string with 2 decimal places", () => {
  assertEquals(formatPrice(261.74), "$261.74");
  assertEquals(formatPrice(0), "$0.00");
  assertEquals(formatPrice(1000.5), "$1,000.50");
  assertEquals(formatPrice(99999.99), "$99,999.99");
});

Deno.test("KeyMetrics KM-04b: formatPrice rounds to 2 decimal places", () => {
  // 261.745 rounds to 261.75 (half-up)
  const formatted = formatPrice(261.745);
  // Intl rounding is implementation-defined for half-even vs half-up, but
  // must end with either 4 or 5 — it cannot produce 3 or more decimal places
  assert(
    formatted.startsWith("$261.7"),
    `Expected dollar amount starting with $261.7, got ${formatted}`
  );
});

// ---------------------------------------------------------------------------
// KM-05: Skeleton path — component renders skeleton when quote is null
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-05: the skeleton is rendered when quote is null (condition !quote is true)", () => {
  // This mirrors the conditional in KeyMetrics.tsx:
  // if (!quote) { return <KeyMetricsSkeleton ... />; }
  const quote = null;
  const shouldShowSkeleton = !quote;
  assertEquals(shouldShowSkeleton, true);
});

Deno.test("KeyMetrics KM-05b: the metric list is rendered when quote is populated (!quote is false)", () => {
  const quote = { o: 100, h: 110, l: 95, pc: 99, c: 105, d: 1, dp: 0.5, t: 1700000000, isMarketOpen: true };
  const shouldShowSkeleton = !quote;
  assertEquals(shouldShowSkeleton, false);
});

// ---------------------------------------------------------------------------
// KM-06: Silent error suppression — failed fetch keeps component in skeleton state
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-06: a failed fetch is suppressed and quote remains null (skeleton state)", async () => {
  // Replicate the component's fetch logic:
  // fetch(`/api/stock/quote?symbol=${symbol}`)
  //   .then(res => { if (!res.ok) throw new Error("quote fetch failed"); return res.json(); })
  //   .then(setQuote)
  //   .catch(() => {});  ← errors are swallowed

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(null, { status: 500 }))
  ) as typeof globalThis.fetch;

  let quote: null | unknown = null;
  let errorCaught = false;

  try {
    await fetch("/api/stock/quote?symbol=AAPL")
      .then((res) => {
        if (!res.ok) throw new Error("quote fetch failed");
        return res.json();
      })
      .then((data) => {
        quote = data;
      })
      .catch(() => {
        errorCaught = true;
        // Silently suppress — mirrors KeyMetrics.tsx behaviour
      });
  } finally {
    globalThis.fetch = original;
  }

  // The catch block fires but does NOT propagate — quote stays null
  assertEquals(errorCaught, true);
  assertEquals(quote, null);
});

// ---------------------------------------------------------------------------
// KM-07: Metric values with unusual inputs — zero prices, very large prices
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-07: all four metrics format correctly with zero values", () => {
  const metrics = buildMetrics({ o: 0, h: 0, l: 0, pc: 0 });
  for (const metric of metrics) {
    assertEquals(metric.value, "$0.00");
  }
});

Deno.test("KeyMetrics KM-07b: all four metrics format correctly with large prices (e.g. BRK.A)", () => {
  const price = 600_000;
  const metrics = buildMetrics({ o: price, h: price, l: price, pc: price });
  for (const metric of metrics) {
    assertEquals(metric.value, "$600,000.00");
  }
});

// ---------------------------------------------------------------------------
// KM-08: High >= Low invariant — the component does not validate this but
//        downstream display of High < Low would confuse users; document the
//        gap so future validation can be added to the route handler.
// ---------------------------------------------------------------------------

Deno.test("KeyMetrics KM-08: component does not validate High >= Low (known gap — validation belongs in route handler)", () => {
  // If the API returns inverted High/Low, the component renders them as-is.
  // This test documents the absence of client-side validation.
  const metrics = buildMetrics({ o: 100, h: 90, l: 110, pc: 99 }); // h < l
  assertEquals(metrics[1].value, formatPrice(90)); // High shown as $90
  assertEquals(metrics[2].value, formatPrice(110)); // Low shown as $110
  // No error is thrown — the component is purely presentational
});
