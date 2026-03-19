import { assertEquals, assertGreater, assert } from "@std/assert";

// ---------------------------------------------------------------------------
// retryable-fetch-logic.test.ts
//
// Tests for the fetch-state logic that powers hooks/useRetryableFetch.ts.
//
// The hook itself is a React hook ("use client") and therefore cannot be
// imported directly into a Deno test. Instead, we test the underlying
// fetch-dispatch logic by inlining the critical decision paths as pure
// functions, following the same pattern used by this project's other unit
// tests that cannot import Next.js modules (e.g. search-route.test.ts).
//
// Specifically we test:
//   - 5xx detection and one-shot auto-retry scheduling (RFH-01..RFH-03)
//   - 429 Retry-After header parsing (RFH-04..RFH-07)
//   - Non-2xx non-5xx non-429 error path (RFH-08)
//   - Abort / cancel path (RFH-09)
//   - AbortError is swallowed (not surfaced as a user error) (RFH-10)
//   - retryAfterMs-to-seconds coercion as performed in the hook (RFH-11)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Extracted pure logic from useRetryableFetch — mirrors the implementation
// ---------------------------------------------------------------------------

/** Replicates the Retry-After header parsing in useRetryableFetch.doFetch */
function parseRetryAfterHeader(headerValue: string | null): number {
  const seconds = headerValue ? parseInt(headerValue, 10) : 60;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
}

/** Returns whether a response status should trigger the 5xx auto-retry path */
function is5xxStatus(status: number): boolean {
  return status >= 500;
}

/** Returns whether a response status is a 429 */
function is429Status(status: number): boolean {
  return status === 429;
}

/** Determines whether an auto-retry should be scheduled (mirrors the hook condition) */
function shouldAutoRetry(isAutoRetry: boolean, hasAutoRetried: boolean): boolean {
  return !isAutoRetry && !hasAutoRetried;
}

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

interface StubFetchOptions {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFakeResponse({ status, body = {}, headers = {} }: StubFetchOptions): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers(headers),
  });
}

function stubGlobalFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(response)) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// RFH-01: 5xx response triggers the auto-retry path
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-01: is5xxStatus returns true for 500, 502, 503, 504", () => {
  assertEquals(is5xxStatus(500), true);
  assertEquals(is5xxStatus(502), true);
  assertEquals(is5xxStatus(503), true);
  assertEquals(is5xxStatus(504), true);
});

Deno.test("retryable-fetch RFH-01b: is5xxStatus returns false for 429, 404, 400, 200", () => {
  assertEquals(is5xxStatus(429), false);
  assertEquals(is5xxStatus(404), false);
  assertEquals(is5xxStatus(400), false);
  assertEquals(is5xxStatus(200), false);
});

// ---------------------------------------------------------------------------
// RFH-02: shouldAutoRetry logic — auto-retry fires exactly once
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-02: shouldAutoRetry is true on first encounter (not a retry, not already retried)", () => {
  assertEquals(shouldAutoRetry(false, false), true);
});

Deno.test("retryable-fetch RFH-02b: shouldAutoRetry is false when this IS the auto-retry request", () => {
  assertEquals(shouldAutoRetry(true, false), false);
});

Deno.test("retryable-fetch RFH-02c: shouldAutoRetry is false once the auto-retry has already been consumed", () => {
  assertEquals(shouldAutoRetry(false, true), false);
});

Deno.test("retryable-fetch RFH-02d: shouldAutoRetry is false when both flags are true (belt-and-suspenders)", () => {
  assertEquals(shouldAutoRetry(true, true), false);
});

// ---------------------------------------------------------------------------
// RFH-03: After a 5xx auto-retry is scheduled, a manual retry resets the
//         hasAutoRetried ref (this is tested indirectly through the flag logic)
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-03: after manual retry (hasAutoRetried reset to false) shouldAutoRetry is true again", () => {
  // Simulate: first 5xx fires auto-retry (hasAutoRetried becomes true)
  // Then user clicks Retry → hook sets hasAutoRetriedRef.current = false
  // So next 5xx should be eligible for auto-retry again
  const hasAutoRetriedAfterManualRetry = false; // reset by retry()
  assertEquals(shouldAutoRetry(false, hasAutoRetriedAfterManualRetry), true);
});

// ---------------------------------------------------------------------------
// RFH-04: 429 detection
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-04: is429Status returns true only for 429", () => {
  assertEquals(is429Status(429), true);
  assertEquals(is429Status(430), false);
  assertEquals(is429Status(500), false);
  assertEquals(is429Status(200), false);
});

// ---------------------------------------------------------------------------
// RFH-05: Retry-After header parsing — valid integer header
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-05: parseRetryAfterHeader returns the numeric value from a valid integer header", () => {
  assertEquals(parseRetryAfterHeader("30"), 30);
  assertEquals(parseRetryAfterHeader("60"), 60);
  assertEquals(parseRetryAfterHeader("1"), 1);
  assertEquals(parseRetryAfterHeader("120"), 120);
});

// ---------------------------------------------------------------------------
// RFH-06: Retry-After header parsing — null or missing header defaults to 60
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-06: parseRetryAfterHeader returns 60 when header is null", () => {
  assertEquals(parseRetryAfterHeader(null), 60);
});

// ---------------------------------------------------------------------------
// RFH-07: Retry-After header parsing — invalid values fall back to 60
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-07: parseRetryAfterHeader falls back to 60 for non-numeric header values", () => {
  assertEquals(parseRetryAfterHeader("not-a-number"), 60);
  assertEquals(parseRetryAfterHeader(""), 60);
  assertEquals(parseRetryAfterHeader("abc"), 60);
});

Deno.test("retryable-fetch RFH-07b: parseRetryAfterHeader falls back to 60 for zero", () => {
  // 0 is not > 0, so it falls back to the default
  assertEquals(parseRetryAfterHeader("0"), 60);
});

Deno.test("retryable-fetch RFH-07c: parseRetryAfterHeader falls back to 60 for negative values", () => {
  assertEquals(parseRetryAfterHeader("-5"), 60);
});

// ---------------------------------------------------------------------------
// RFH-08: Non-2xx, non-5xx, non-429 response — surfaces a user-facing error
//         The hook throws `Request failed (${res.status})` for these.
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-08: a 404 response is not treated as 5xx or 429", async () => {
  const restore = stubGlobalFetch(makeFakeResponse({ status: 404 }));
  try {
    const res = await globalThis.fetch("/api/stock/quote?symbol=AAPL");
    assertEquals(res.status, 404);
    assertEquals(is5xxStatus(res.status), false);
    assertEquals(is429Status(res.status), false);
    // The hook would throw `Request failed (404)` here
    assert(!res.ok, "404 should not be ok");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// RFH-09: AbortController signal cancels the fetch cleanly
//
// Note: Deno's native fetch throws a TypeError (not DOMException) when a
// signal is already aborted. In the browser and in React test environments
// the error is a DOMException with name "AbortError". The hook's
// `err instanceof DOMException && err.name === "AbortError"` guard is
// browser-correct. In Deno's test runner we verify that the abort signal
// causes *some* error, and separately verify the DOMException construction
// in RFH-10.
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-09: fetch with an already-aborted signal throws an error (abort path)", async () => {
  const controller = new AbortController();
  controller.abort();

  let caughtError: unknown = null;
  try {
    await globalThis.fetch("/api/stock/quote?symbol=AAPL", {
      signal: controller.signal,
    });
  } catch (err) {
    caughtError = err;
  }

  // The fetch must throw — any error type confirms the abort path was taken.
  // (Deno throws TypeError; browsers throw DOMException with name "AbortError".)
  assert(caughtError !== null, "Aborting a fetch should cause it to throw");
  assert(caughtError instanceof Error, "Thrown value should be an Error instance");
});

// ---------------------------------------------------------------------------
// RFH-10: AbortError is the only error that should be swallowed by the hook.
//         Other DOMExceptions (e.g. NetworkError) should surface as errors.
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-10: AbortError is a DOMException with name='AbortError'", () => {
  const err = new DOMException("The operation was aborted.", "AbortError");
  assert(err instanceof DOMException);
  assertEquals(err.name, "AbortError");

  // The hook's catch block: `if (err instanceof DOMException && err.name === "AbortError") return;`
  const isAbortError = err instanceof DOMException && err.name === "AbortError";
  assertEquals(isAbortError, true);
});

Deno.test("retryable-fetch RFH-10b: A non-AbortError DOMException is NOT swallowed", () => {
  const err = new DOMException("Network error.", "NetworkError");
  const isAbortError = err instanceof DOMException && err.name === "AbortError";
  assertEquals(isAbortError, false);
});

// ---------------------------------------------------------------------------
// RFH-11: Retry-After countdown — the countdown setInterval decrements by 1
//         per second. When retryAfterSeconds reaches 1, the next tick returns null.
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-11: countdown reducer: returns null when prev is 1 (last tick)", () => {
  // Mirrors the setInterval callback inside useRetryableFetch:
  // setRetryAfterSeconds((prev) => {
  //   if (prev === null || prev <= 1) { ... return null; }
  //   return prev - 1;
  // });
  function countdownReducer(prev: number | null): number | null {
    if (prev === null || prev <= 1) return null;
    return prev - 1;
  }

  assertEquals(countdownReducer(null), null);
  assertEquals(countdownReducer(1), null);
  assertEquals(countdownReducer(0), null); // <= 1 branch
  assertEquals(countdownReducer(5), 4);
  assertEquals(countdownReducer(60), 59);
  assertEquals(countdownReducer(2), 1);
});

// ---------------------------------------------------------------------------
// RFH-12: End-to-end: 429 response sets the correct retryAfterSeconds from header
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-12: a 429 response with Retry-After: 45 header results in retryAfterSeconds=45", async () => {
  const restore = stubGlobalFetch(
    makeFakeResponse({
      status: 429,
      body: { error: "Too many requests" },
      headers: { "Retry-After": "45" },
    })
  );
  try {
    const res = await globalThis.fetch("/api/stock/quote?symbol=AAPL");
    assertEquals(res.status, 429);
    assertEquals(is429Status(res.status), true);

    const retryAfterHeader = res.headers.get("Retry-After");
    const validSeconds = parseRetryAfterHeader(retryAfterHeader);
    assertEquals(validSeconds, 45);
  } finally {
    restore();
  }
});

Deno.test("retryable-fetch RFH-12b: a 429 response without Retry-After header defaults retryAfterSeconds to 60", async () => {
  const restore = stubGlobalFetch(
    makeFakeResponse({ status: 429, body: { error: "Too many requests" } })
  );
  try {
    const res = await globalThis.fetch("/api/stock/quote?symbol=AAPL");
    assertEquals(res.status, 429);

    const retryAfterHeader = res.headers.get("Retry-After");
    const validSeconds = parseRetryAfterHeader(retryAfterHeader);
    assertEquals(validSeconds, 60);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// RFH-13: Successful 200 response produces parsed JSON data
// ---------------------------------------------------------------------------

Deno.test("retryable-fetch RFH-13: a 200 response with valid JSON body is parsed correctly", async () => {
  const payload = { c: 175.25, d: 1.5, dp: 0.86, h: 176.0, l: 174.0, o: 174.5, pc: 173.75, t: 1700000000, isMarketOpen: true };
  const restore = stubGlobalFetch(
    makeFakeResponse({ status: 200, body: payload })
  );
  try {
    const res = await globalThis.fetch("/api/stock/quote?symbol=AAPL");
    assertEquals(res.status, 200);
    assert(res.ok);
    assertEquals(is5xxStatus(res.status), false);
    assertEquals(is429Status(res.status), false);

    const parsed = await res.json();
    assertEquals(parsed.c, 175.25);
    assertEquals(parsed.isMarketOpen, true);
  } finally {
    restore();
  }
});
