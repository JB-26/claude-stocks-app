import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// concurrency.test.ts
//
// Unit tests for lib/concurrency.ts — mapWithConcurrencyLimit.
//
// The module is deliberately free of Next.js/Finnhub imports, so it can be
// imported directly here with a relative path and no mocking.
// ---------------------------------------------------------------------------

import { mapWithConcurrencyLimit } from "../../lib/concurrency.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Narrowing helper — asserts a settled result fulfilled and returns its value. */
function fulfilledValue<R>(result: PromiseSettledResult<R>): R {
  assertEquals(result.status, "fulfilled");
  return (result as PromiseFulfilledResult<R>).value;
}

// ---------------------------------------------------------------------------
// CC-01: results preserve input order regardless of completion timing
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-01: results are returned in input order even when later items resolve first", async () => {
  const items = [0, 1, 2, 3, 4, 5];

  // Reverse the delays so the LAST item of each chunk resolves first.
  const results = await mapWithConcurrencyLimit(items, 3, async (n) => {
    await delay((items.length - n) * 5);
    return `item-${n}`;
  });

  assertEquals(results.length, items.length);
  assertEquals(
    results.map((r) => fulfilledValue(r)),
    ["item-0", "item-1", "item-2", "item-3", "item-4", "item-5"]
  );
});

// ---------------------------------------------------------------------------
// CC-02: SUSTAINS `limit` calls in flight — a slow item must not stall the pool
//
// The previous version of this test only asserted `maxInFlight <= limit`, which
// a fully sequential implementation also satisfies, and `maxInFlight > 1`,
// which a chunk-and-await-per-chunk implementation satisfies too (every chunk
// starts `limit` calls at once). Neither could detect the real defect: chunking
// makes total time the sum of per-chunk maxima, so one slow item blocks every
// later chunk and average in-flight collapses towards 1.
//
// The discriminating observation is CAUSAL, not a wall-clock threshold: with a
// worker pool, the freed workers keep pulling new items while the slow item is
// still running, so all `total - 1` fast items start before it finishes. With
// chunking, only the `limit - 1` other members of the slow item's own chunk can
// ever start before it completes.
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-02: sustains `limit` calls in flight — one slow item does not stall the pool", async () => {
  const limit = 4;
  const total = 16;
  const SLOW_MS = 300;
  const FAST_MS = 20;

  // Pool timing: 15 fast items across the 3 non-blocked workers is 5 rounds of
  // 20ms = ~100ms, comfortably inside the slow item's 300ms.
  const items = Array.from({ length: total }, (_, i) => i);

  let inFlight = 0;
  let maxInFlight = 0;
  let slowItemRunning = false;
  let startedWhileSlowRunning = 0;

  const results = await mapWithConcurrencyLimit(items, limit, async (n) => {
    const isSlow = n === 0;

    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (isSlow) slowItemRunning = true;
    else if (slowItemRunning) startedWhileSlowRunning++;

    await delay(isSlow ? SLOW_MS : FAST_MS);

    if (isSlow) slowItemRunning = false;
    inFlight--;
    return n;
  });

  assertEquals(results.length, total);
  assertEquals(results.map((r) => fulfilledValue(r)), items);

  assert(
    maxInFlight <= limit,
    `expected at most ${limit} concurrent calls, observed ${maxInFlight}`
  );
  assertEquals(
    maxInFlight,
    limit,
    `expected the pool to reach its full limit of ${limit}, observed ${maxInFlight}`
  );

  // A chunked implementation scores exactly limit - 1 (== 3) here; a real pool
  // scores total - 1 (== 15). The threshold sits well clear of both.
  assert(
    startedWhileSlowRunning >= total - limit,
    `expected at least ${total - limit} items to start while the slow item was still ` +
      `in flight (a pool sustains ${limit} in flight); observed ${startedWhileSlowRunning}, ` +
      `which indicates chunk-and-await rather than a worker pool`
  );
});

// ---------------------------------------------------------------------------
// CC-03: a rejection does not abort or fail the batch (settled semantics)
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-03: one rejected item does not stop the others from resolving", async () => {
  const items = ["a", "b", "c", "d"];

  const results = await mapWithConcurrencyLimit(items, 2, (item) => {
    if (item === "b") return Promise.reject(new Error("boom"));
    return Promise.resolve(item.toUpperCase());
  });

  assertEquals(results.length, 4);
  assertEquals(results.map((r) => r.status), [
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
  assertEquals(fulfilledValue(results[0]), "A");
  assertEquals(fulfilledValue(results[2]), "C");
  assertEquals(fulfilledValue(results[3]), "D");

  const rejected = results[1] as PromiseRejectedResult;
  assert(rejected.reason instanceof Error);
  assertEquals(rejected.reason.message, "boom");
});

// ---------------------------------------------------------------------------
// CC-03b: a rejection in one chunk does not prevent later chunks from running
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-03b: a rejection in an early chunk still lets later chunks run", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  const called: number[] = [];

  const results = await mapWithConcurrencyLimit(items, 2, (n) => {
    called.push(n);
    if (n <= 2) return Promise.reject(new Error(`fail-${n}`));
    return Promise.resolve(n * 10);
  });

  assertEquals(called, items); // every item was attempted
  assertEquals(results.map((r) => r.status), [
    "rejected",
    "rejected",
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  assertEquals(fulfilledValue(results[5]), 60);
});

// ---------------------------------------------------------------------------
// CC-04: empty input resolves to an empty array without invoking fn
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-04: empty input returns [] and never calls fn", async () => {
  let calls = 0;

  const results = await mapWithConcurrencyLimit([], 5, () => {
    calls++;
    return Promise.resolve("never");
  });

  assertEquals(results, []);
  assertEquals(calls, 0);
});

// ---------------------------------------------------------------------------
// CC-05: a limit larger than the item count still processes everything once
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-05: a limit greater than the item count processes each item exactly once", async () => {
  const items = ["AAPL", "MSFT"];
  const calls: string[] = [];

  const results = await mapWithConcurrencyLimit(items, 20, (s) => {
    calls.push(s);
    return Promise.resolve(s);
  });

  assertEquals(calls, ["AAPL", "MSFT"]);
  assertEquals(results.map((r) => fulfilledValue(r)), ["AAPL", "MSFT"]);
});

// ---------------------------------------------------------------------------
// CC-06: a non-positive limit is clamped to 1 rather than looping forever
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-06: a limit of 0 is clamped to sequential execution instead of hanging", async () => {
  const items = [1, 2, 3];

  const results = await mapWithConcurrencyLimit(items, 0, (n) =>
    Promise.resolve(n)
  );

  assertEquals(results.map((r) => fulfilledValue(r)), [1, 2, 3]);
});

Deno.test("concurrency CC-06b: a negative limit still processes every item", async () => {
  const results = await mapWithConcurrencyLimit([1, 2, 3], -5, (n) =>
    Promise.resolve(n)
  );
  assertEquals(results.map((r) => fulfilledValue(r)), [1, 2, 3]);
});

Deno.test("concurrency CC-06c: a fractional limit is floored, not rounded up", async () => {
  const items = Array.from({ length: 6 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;

  await mapWithConcurrencyLimit(items, 2.9, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(5);
    inFlight--;
    return n;
  });

  assertEquals(maxInFlight, 2, "2.9 must floor to 2 workers, not ceil to 3");
});

// ---------------------------------------------------------------------------
// CC-07: non-finite limits (defect: `Math.max(1, Math.floor(NaN))` is NaN)
//
// The old guard produced NaN, so `slice(0, NaN)` was empty and `i += NaN` ended
// the loop immediately: mapWithConcurrencyLimit returned [] with `fn` NEVER
// invoked — silently discarding every item while reporting success. These
// tests pin the documented contract instead: one settled result per input item,
// whatever the caller passed as a limit.
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-07: a NaN limit still invokes fn for every item and returns one result each", async () => {
  const items = ["AAPL", "MSFT", "TSLA"];
  const calls: string[] = [];

  const results = await mapWithConcurrencyLimit(items, NaN, (s) => {
    calls.push(s);
    return Promise.resolve(s.toLowerCase());
  });

  assertEquals(calls, items, "fn must be called for every item on a NaN limit");
  assertEquals(results.length, items.length);
  assertEquals(results.map((r) => fulfilledValue(r)), ["aapl", "msft", "tsla"]);
});

Deno.test("concurrency CC-07b: an undefined limit (untyped caller) still processes every item", async () => {
  const items = [1, 2, 3];
  const calls: number[] = [];

  const results = await mapWithConcurrencyLimit(
    items,
    undefined as unknown as number,
    (n) => {
      calls.push(n);
      return Promise.resolve(n * 2);
    }
  );

  assertEquals(calls, items);
  assertEquals(results.map((r) => fulfilledValue(r)), [2, 4, 6]);
});

Deno.test("concurrency CC-07c: an Infinity limit fails closed to sequential rather than unbounded", async () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await mapWithConcurrencyLimit(items, Infinity, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(1);
    inFlight--;
    return n;
  });

  assertEquals(results.map((r) => fulfilledValue(r)), items);
  // Deliberate: this helper exists to BOUND fan-out onto a shared API key, so a
  // non-finite limit is treated as a bug and clamped to 1. Failing open to
  // unbounded parallelism would defeat its only purpose.
  assertEquals(
    maxInFlight,
    1,
    "a non-finite limit must fail closed (sequential), never unbounded"
  );
});

// ---------------------------------------------------------------------------
// CC-08: a synchronous throw from fn is captured as a rejected result
// ---------------------------------------------------------------------------

Deno.test("concurrency CC-08: fn throwing synchronously becomes a rejected result, not an unhandled error", async () => {
  const results = await mapWithConcurrencyLimit([1, 2, 3], 2, (n) => {
    if (n === 2) throw new Error("sync boom");
    return Promise.resolve(n);
  });

  assertEquals(results.map((r) => r.status), [
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  assertEquals((results[1] as PromiseRejectedResult).reason.message, "sync boom");
});
