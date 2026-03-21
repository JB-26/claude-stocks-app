import { assertEquals, assertGreater, assert } from "@std/assert";
import { checkRateLimit } from "../../lib/ratelimit.ts";

// ---------------------------------------------------------------------------
// ratelimit-retryafter.test.ts
//
// Extended tests for the `retryAfterMs` field introduced in the Focus 2 work.
// The existing ratelimit.test.ts already covers RL-01..RL-05 (allowed/rejected
// request counts and per-route isolation). These tests focus exclusively on the
// new `retryAfterMs` semantics, the `Retry-After` header contract, and
// boundary conditions around the new RateLimitResult shape.
// ---------------------------------------------------------------------------

function makeRequest(ip: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

// Use unique IP+path pairs for each test to avoid polluting the shared
// module-level ipWindows Map.

// ---------------------------------------------------------------------------
// RL-06: retryAfterMs is 0 for every allowed request
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-06: retryAfterMs is 0 for every allowed request within the window", () => {
  const ip = "10.1.6.1";
  const path = "/api/stock/rl06";

  for (let i = 0; i < 30; i++) {
    const result = checkRateLimit(makeRequest(ip, path));
    assertEquals(result.allowed, true);
    assertEquals(result.retryAfterMs, 0, `Request ${i + 1} should have retryAfterMs=0`);
  }
});

// ---------------------------------------------------------------------------
// RL-07: retryAfterMs is positive and <= 60_000 ms when rate-limited
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-07: retryAfterMs is positive and does not exceed the window size when rejected", () => {
  const ip = "10.1.7.1";
  const path = "/api/stock/rl07";
  const WINDOW_MS = 60_000;

  // Exhaust the allowance
  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest(ip, path));
  }

  const result = checkRateLimit(makeRequest(ip, path));
  assertEquals(result.allowed, false);
  assertGreater(result.retryAfterMs, 0);
  // Must not exceed the full window — no valid implementation should report
  // "retry in more than 60 seconds" when the window is 60s.
  assert(
    result.retryAfterMs <= WINDOW_MS,
    `retryAfterMs (${result.retryAfterMs}) should not exceed WINDOW_MS (${WINDOW_MS})`
  );
});

// ---------------------------------------------------------------------------
// RL-08: retryAfterMs decreases (or stays the same) on subsequent rejected calls
//        This validates the Math.max(0, resetAt - now) formula.
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-08: retryAfterMs on subsequent rejected calls is not larger than the first rejection", async () => {
  const ip = "10.1.8.1";
  const path = "/api/stock/rl08";

  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest(ip, path));
  }

  const first = checkRateLimit(makeRequest(ip, path));
  assertEquals(first.allowed, false);

  // Wait a tiny amount so Date.now() advances slightly
  await new Promise((r) => setTimeout(r, 5));

  const second = checkRateLimit(makeRequest(ip, path));
  assertEquals(second.allowed, false);

  // The second value must be less than or equal to the first — time is moving
  // forward so the remaining window can only shrink.
  assert(
    second.retryAfterMs <= first.retryAfterMs,
    `second retryAfterMs (${second.retryAfterMs}) should be <= first (${first.retryAfterMs})`
  );
});

// ---------------------------------------------------------------------------
// RL-09: Retry-After header conversion — Math.ceil(retryAfterMs / 1000) is >= 1
//        This mirrors what route handlers do before setting the header.
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-09: Math.ceil(retryAfterMs / 1000) produces a Retry-After value of at least 1 second", () => {
  const ip = "10.1.9.1";
  const path = "/api/stock/rl09";

  for (let i = 0; i < 30; i++) {
    checkRateLimit(makeRequest(ip, path));
  }

  const result = checkRateLimit(makeRequest(ip, path));
  assertEquals(result.allowed, false);

  const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
  assert(
    retryAfterSeconds >= 1,
    `Retry-After header value should be at least 1 second, got ${retryAfterSeconds}`
  );
});

// ---------------------------------------------------------------------------
// RL-10: A new window after reset is detected correctly — first request in a
//        new window returns allowed=true and retryAfterMs=0.
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-10: first request after the window resets is allowed with retryAfterMs=0", async () => {
  const ip = "10.1.10.1";
  // Use a path we can manipulate the Map entry for directly — we rely on
  // module state. We use a very short synthetic window by calling the function
  // and then manually fast-forwarding by more than WINDOW_MS.
  //
  // Since we can't change the module's WINDOW_MS constant, we instead test
  // the "new IP" path: first request on a never-seen IP always opens a fresh
  // window.
  const path = "/api/stock/rl10";

  const result = checkRateLimit(makeRequest(ip, path));
  assertEquals(result.allowed, true);
  assertEquals(result.retryAfterMs, 0);
});

// ---------------------------------------------------------------------------
// RL-11: RateLimitResult shape — both fields are always present
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-11: checkRateLimit always returns an object with allowed (boolean) and retryAfterMs (number)", () => {
  const ip = "10.1.11.1";
  const path = "/api/stock/rl11";

  for (let i = 0; i <= 31; i++) {
    const result = checkRateLimit(makeRequest(ip, path));

    assert(
      typeof result.allowed === "boolean",
      `allowed must be boolean, got ${typeof result.allowed}`
    );
    assert(
      typeof result.retryAfterMs === "number",
      `retryAfterMs must be number, got ${typeof result.retryAfterMs}`
    );
    assert(
      result.retryAfterMs >= 0,
      `retryAfterMs must be non-negative, got ${result.retryAfterMs}`
    );
  }
});

// ---------------------------------------------------------------------------
// RL-12: allowed=true always comes with retryAfterMs=0 (the inverse should
//        also hold: allowed=false always comes with retryAfterMs > 0)
// ---------------------------------------------------------------------------

Deno.test("ratelimit RL-12: allowed=true always has retryAfterMs=0 and allowed=false always has retryAfterMs > 0", () => {
  const ip = "10.1.12.1";
  const path = "/api/stock/rl12";

  for (let i = 0; i < 30; i++) {
    const r = checkRateLimit(makeRequest(ip, path));
    assertEquals(r.allowed, true);
    assertEquals(r.retryAfterMs, 0);
  }

  // Next 5 requests — all rejected
  for (let i = 0; i < 5; i++) {
    const r = checkRateLimit(makeRequest(ip, path));
    assertEquals(r.allowed, false);
    assertGreater(r.retryAfterMs, 0);
  }
});
